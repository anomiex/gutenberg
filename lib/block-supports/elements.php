<?php
/**
 * Elements styles block support.
 *
 * @package gutenberg
 */

/**
 * Get the elements class names.
 *
 * @param array $block Block object.
 * @return string      The unique class name.
 */
function gutenberg_get_elements_class_name( $block ) {
	return 'wp-elements-' . md5( serialize( $block ) );
}

/**
 * Update the block content with elements class names.
 *
 * @param  string $block_content Rendered block content.
 * @param  array  $block         Block object.
 * @return string                Filtered block content.
 */
function gutenberg_render_elements_support( $block_content, $block ) {
	if ( ! $block_content || empty( $block['attrs'] ) ) {
		return $block_content;
	}

	$block_type = WP_Block_Type_Registry::get_instance()->get_registered( $block['blockName'] );

	$element_color_properties = array(
		'button'  => array(
			'skip'  => wp_should_skip_block_supports_serialization( $block_type, 'color', 'button' ),
			'paths' => array(
				'style.elements.button.color.text',
				'style.elements.button.color.background',
				'style.elements.button.color.gradient',
			),
		),
		'link'    => array(
			'skip'  => wp_should_skip_block_supports_serialization( $block_type, 'color', 'link' ),
			'paths' => array(
				'style.elements.link.color.text',
				'style.elements.link.:hover.color.text',
			),
		),
		'heading' => array(
			'skip'  => wp_should_skip_block_supports_serialization( $block_type, 'color', 'heading' ),
			'paths' => array(
				'style.elements.heading.color.text',
				'style.elements.heading.color.background',
				'style.elements.heading.color.gradient',
				'style.elements.h1.color.text',
				'style.elements.h1.color.background',
				'style.elements.h1.color.gradient',
				'style.elements.h2.color.text',
				'style.elements.h2.color.background',
				'style.elements.h2.color.gradient',
				'style.elements.h3.color.text',
				'style.elements.h3.color.background',
				'style.elements.h3.color.gradient',
				'style.elements.h4.color.text',
				'style.elements.h4.color.background',
				'style.elements.h4.color.gradient',
				'style.elements.h5.color.text',
				'style.elements.h5.color.background',
				'style.elements.h5.color.gradient',
				'style.elements.h6.color.text',
				'style.elements.h6.color.background',
				'style.elements.h6.color.gradient',
			),
		),
	);

	$skip_all_element_color_serialization = $element_color_properties['button']['skip'] &&
		$element_color_properties['link']['skip'] &&
		$element_color_properties['heading']['skip'];

	if ( $skip_all_element_color_serialization ) {
		return $block_content;
	}

	$element_colors_set = 0;

	foreach ( $element_color_properties as $element_config ) {
		if ( $element_config['skip'] ) {
			continue;
		}

		foreach ( $element_config['paths'] as $path ) {
			if ( null !== _wp_array_get( $block['attrs'], explode( '.', $path ), null ) ) {
				$element_colors_set++;
			}
		}
	}

	if ( ! $element_colors_set ) {
		return $block_content;
	}

	// Like the layout hook this assumes the hook only applies to blocks with a single wrapper.
	// Add the class name to the first element, presuming it's the wrapper, if it exists.
	$tags = new WP_HTML_Tag_Processor( $block_content );
	if ( $tags->next_tag() ) {
		$tags->add_class( gutenberg_get_elements_class_name( $block ) );
	}

	return $tags->get_updated_html();
}

/**
 * Render the elements stylesheet.
 *
 * In the case of nested blocks we want the parent element styles to be rendered before their descendants.
 * This solves the issue of an element (e.g.: link color) being styled in both the parent and a descendant:
 * we want the descendant style to take priority, and this is done by loading it after, in DOM order.
 *
 * @param string|null $pre_render   The pre-rendered content. Default null.
 * @param array       $block The block being rendered.
 *
 * @return null
 */
function gutenberg_render_elements_support_styles( $pre_render, $block ) {
	$block_type           = WP_Block_Type_Registry::get_instance()->get_registered( $block['blockName'] );
	$element_block_styles = isset( $block['attrs']['style']['elements'] ) ? $block['attrs']['style']['elements'] : null;

	if ( ! $element_block_styles ) {
		return null;
	}

	$skip_link_color_serialization         = wp_should_skip_block_supports_serialization( $block_type, 'color', 'link' );
	$skip_heading_color_serialization      = wp_should_skip_block_supports_serialization( $block_type, 'color', 'heading' );
	$skip_button_color_serialization       = wp_should_skip_block_supports_serialization( $block_type, 'color', 'button' );
	$skips_all_element_color_serialization = $skip_link_color_serialization &&
		$skip_heading_color_serialization &&
		$skip_button_color_serialization;

	if ( $skips_all_element_color_serialization ) {
		return null;
	}

	$class_name = gutenberg_get_elements_class_name( $block );

	$element_types = array(
		'button'  => array(
			'selector' => ".$class_name .wp-element-button, .$class_name .wp-block-button__link",
			'skip'     => $skip_button_color_serialization,
		),
		'link'    => array(
			'selector'       => ".$class_name a",
			'hover_selector' => ".$class_name a:hover",
			'skip'           => $skip_link_color_serialization,
		),
		'heading' => array(
			'selector' => ".$class_name h1, .$class_name h2, .$class_name h3, .$class_name h4, .$class_name h5, .$class_name h6",
			'skip'     => $skip_heading_color_serialization,
			'elements' => array( 'h1', 'h2', 'h3', 'h4', 'h5', 'h6' ),
		),
	);

	foreach ( $element_types as $element_type => $element_config ) {
		if ( $element_config['skip'] ) {
			continue;
		}

		$element_style_object = _wp_array_get( $element_block_styles, array( $element_type ), null );

		// Process primary element type styles.
		if ( $element_style_object ) {
			gutenberg_style_engine_get_styles(
				$element_style_object,
				array(
					'selector' => $element_config['selector'],
					'context'  => 'block-supports',
				)
			);

			if ( isset( $element_style_object[':hover'] ) ) {
				gutenberg_style_engine_get_styles(
					$element_style_object[':hover'],
					array(
						'selector' => $element_config['hover_selector'],
						'context'  => 'block-supports',
					)
				);
			}
		}

		// Process related elements e.g. h1-h6 for headings.
		if ( isset( $element_config['elements'] ) ) {
			foreach ( $element_config['elements'] as $element ) {
				$element_style_object = _wp_array_get( $element_block_styles, array( $element ), null );

				if ( $element_style_object ) {
					gutenberg_style_engine_get_styles(
						$element_style_object,
						array(
							'selector' => ".$class_name $element",
							'context'  => 'block-supports',
						)
					);
				}
			}
		}
	}

	return null;
}

// Remove WordPress core filters to avoid rendering duplicate elements stylesheet & attaching classes twice.
remove_filter( 'render_block', 'wp_render_elements_support', 10, 2 );
remove_filter( 'pre_render_block', 'wp_render_elements_support_styles', 10, 2 );
add_filter( 'render_block', 'gutenberg_render_elements_support', 10, 2 );
add_filter( 'pre_render_block', 'gutenberg_render_elements_support_styles', 10, 2 );
